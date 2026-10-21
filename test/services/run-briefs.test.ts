import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../../src/domain/run-machine.ts";
import { VERSION } from "../../src/infra/version.ts";
import { appendCheckRecord, type CheckRecord } from "../../src/services/milestone-check.ts";
import { briefFor, judgeBrief } from "../../src/services/run-briefs.ts";
import { scratchDir } from "../../src/services/dispatches.ts";
import { snapshotEnv } from "../helpers.ts";
import { endDispatch, runningLog, startDispatch, makeLog } from "../domain/run-fixtures.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { copyPlanInputs, planDocs, taskBlock } from "../../src/services/plan-input.ts";
import { writeRunReport } from "../../src/services/run-report.ts";
import { appendRecord, type Run } from "../../src/services/run-store.ts";
import { PLAN, startedFields } from "../domain/run-fixtures.ts";
import { briefFor as withLane, freshRun, makeRecord, PLAN_TEXT, writeLane } from "./helpers.ts";

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

  it("carries the owner's answer to a parked milestone into its next brief", () => {
    const { run } = freshRun();
    const log = runningLog();
    log.add("question.parked", { unit: "M1", question: "which db?", reason: "needs_user" });
    log.add("question.answered", { unit: "M1", answer: "use postgres", by: "owner" });
    const s = log.state();
    for (const brief of ["review", "verify", "architect"] as const) {
      const text = briefFor(
        run,
        s,
        act({
          brief,
          role: brief === "architect" ? "architect" : "verifier",
          name: `${brief}-M1`,
          unit: "M1",
          lane: null,
        }),
      );
      expect(text).toContain("The owner answered: use postgres");
    }
    // another milestone's brief does not
    expect(
      briefFor(
        run,
        s,
        act({ brief: "verify", role: "verifier", name: "verifier-M2", unit: "M2", lane: null }),
      ),
    ).not.toContain("use postgres");
  });

  it("carries the owner's answer to a parked planning role into its retried brief", () => {
    const { run } = freshRun();
    const log = runningLog();
    log.add("question.parked", { unit: "run", question: "which spec?", reason: "needs_user" });
    log.add("question.answered", { unit: "run", answer: "use the v2 spec", by: "owner" });
    const s = log.state();
    for (const [brief, role] of [
      ["architect", "architect"],
      ["dossier", "researcher"],
    ] as const)
      expect(briefFor(run, s, act({ brief, role, name: role, unit: "run", lane: null }))).toContain(
        "The owner answered: use the v2 spec",
      );
  });

  it("gives a fix-round worker the tail of the milestone's latest failing check", () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a/"]);
    const log = join(run.dir, "check.log");
    writeFileSync(log, Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join("\n"));
    const rec = (over: Partial<CheckRecord>): CheckRecord => ({
      at: "2026-10-21T10:00:00.000Z",
      run: run.id,
      milestone: "M1",
      command: "bun test",
      head: "0123456789abcdef",
      exit: 1,
      durationMs: 1,
      fails: [],
      log,
      ...over,
    });
    const fix = () =>
      briefFor(
        run,
        runningLog().state(),
        act({ brief: "fix", notes: ["BUG src/a/x.ts:3 — wrong — fix it"] }),
      );
    expect(fix()).not.toContain("the end of its log");
    appendCheckRecord(run.meta.repo, rec({}));
    const text = fix();
    expect(text).toContain("The milestone check `bun test` exited 1 on 0123456789ab; the end of its log:");
    expect(text).toContain("l50");
    expect(text).toContain("l11");
    expect(text).not.toContain("l10\n");
    // a baseline record never counts, and a later passing check removes the paragraph
    appendCheckRecord(run.meta.repo, rec({ baseline: true, exit: 0 }));
    expect(fix()).toContain("the end of its log");
    appendCheckRecord(run.meta.repo, rec({ exit: 0 }));
    expect(fix()).not.toContain("the end of its log");
  });

  it("tells the integrate worker which files are in conflict, to resolve them and to commit nothing", () => {
    const { run } = freshRun();
    const s = runningLog(undefined, "main").state();
    const text = briefFor(
      run,
      s,
      act({ unit: "M1", name: "worker-M1-integrate", lane: null, brief: "fix", notes: ["src/a/x.ts"] }),
    );
    expect(text).toContain("The base branch main moved");
    expect(text).toContain("- src/a/x.ts");
    expect(text).toContain("do not commit or stage anything");
    expect(text).not.toContain("Owns:");
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

describe("briefs from the plan (plan 32)", () => {
  /** a daemon run on the plan file p.md, with lanes M1.L1 (tasks 1, 2) and M1.L2 (task 1b is not there: task 3) */
  async function planned(): Promise<{
    run: Run;
    repo: string;
    s: ReturnType<ReturnType<typeof runningLog>["state"]>;
  }> {
    const { run, repo } = freshRun();
    const file = join(repo, "p.md");
    writeFileSync(file, PLAN_TEXT);
    await appendEvent(run, { type: "run.started", ...startedFields, repo, plan: [file] });
    copyPlanInputs(run, [file]);
    writeLane(run, "M1.L1", ["src/a/"], "bun test a", "Kind: repo_code\nDifficulty: build\nTasks: 1, 2\n");
    writeLane(run, "M1.L2", ["src/b/"], "bun test b", "Kind: repo_code\nDifficulty: build\nTasks: 2\n");
    const log = runningLog(PLAN, { ...startedFields, plan: [file] });
    return { run, repo, s: log.state() };
  }

  it("gives a lane's worker its plan tasks verbatim, and a fix worker every lane's fast check too", async () => {
    const { run, s } = await planned();
    const lane = briefFor(run, s, act({}));
    expect(lane).toContain(
      "Your plan tasks. Implement them as written; where one conflicts with the code, reply DESIGN: as your role text says.",
    );
    const tasks = [1, 2].map((n) =>
      taskBlock(planDocs(run)[0]?.tasks.find((t) => t.id === String(n)) as never),
    );
    for (const t of tasks) expect(lane).toContain(t);
    expect(lane).not.toContain("fast checks of");
    const fix = briefFor(run, s, act({ brief: "fix", notes: ["BUG src/a/x.ts:3 — wrong — fix it"] }));
    expect(fix).toContain("The fast checks of M1's lanes; run the ones whose files you change:");
    expect(fix).toContain("- M1.L1 (src/a/): `bun test a`");
    expect(fix).toContain("- M1.L2 (src/b/, src/b2.ts): `bun test b`");
  });

  it("tells the architect the owner's plan copies, or to write a deep plan for approval, with what to change", async () => {
    const { run, s } = await planned();
    const base = act({ brief: "architect", role: "architect", lane: null, unit: "run", name: "architect" });
    const given = briefFor(run, s, base);
    expect(given).toContain("The owner's approved plan: plan-input/p.md (read each with read_run_file).");
    expect(given).toContain("Lane the tasks the acceptance lines name, or every task when they name none.");
    expect(given).toContain("Tasks: <plan task numbers");
    const none = makeLog();
    none.add("run.started", startedFields);
    const written = briefFor(run, none.state(), {
      ...base,
      notes: ["The owner asked for these changes to plan.md: rename Ledger"],
    });
    expect(written).toContain("No plan was given: write plan.md to the depth your role text sets.");
    expect(written).toContain("The run waits for the owner's approval of it before any lane runs.");
    expect(written).toContain(
      "What to change:\n- The owner asked for these changes to plan.md: rename Ledger",
    );
    expect(written).not.toContain("called back on");
  });

  it("gives the reviewer the milestone's tasks and every out-of-lane file, declared or not", async () => {
    const { run, s } = await planned();
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        lane: "M1.L1",
        name: "worker-M1.L1",
        violations: ["src/x.ts", "b.md"],
        extras: [{ path: "src/x.ts", why: "the type lives there" }],
      }),
    );
    const text = briefFor(
      run,
      s,
      act({ brief: "review", role: "reviewer", name: "reviewer-M1", unit: "M1", lane: null }),
    );
    expect(text).toContain("The plan tasks this milestone implements:");
    expect(text).toContain('<plan-task file="p.md" id="1">');
    expect(text).toContain("Files changed outside their lane:");
    expect(text).toContain("- src/x.ts — declared by worker-M1.L1: the type lives there");
    expect(text).toContain("- b.md — not declared by worker-M1.L1");
  });

  it("hands a fix round's REJECTED lines to the re-check, and none recorded before the review", async () => {
    const { run, repo } = await planned();
    const log = runningLog(PLAN, { ...startedFields, plan: [join(repo, "p.md")] });
    const id = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, id, { name: "reviewer-M1", unit: "M1" });
    mkdirSync(join(run.dir, "roles", "reviewer-M1", id), { recursive: true });
    writeFileSync(join(run.dir, "roles", "reviewer-M1", id, "reply.md"), "BUG src/a/x.ts:3 — wrong — fix\n");
    const endedAt = log.events.at(-1)?.at as string;
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: "01J00000000000000000000B01",
        endedAt: new Date(Date.parse(endedAt) - 5000).toISOString(),
        rejected: [{ finding: "BUG old", why: "before the review" }],
      }),
    );
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: "01J00000000000000000000B02",
        endedAt: new Date(Date.parse(endedAt) + 5000).toISOString(),
        rejected: [{ finding: "BUG a", why: "stale diff" }],
      }),
    );
    const text = briefFor(
      run,
      log.state(),
      act({ brief: "recheck", role: "reviewer", name: "reviewer-M1", unit: "M1", lane: null }),
    );
    expect(text).toContain(
      "A fix round rejected these findings instead of changing the code. Judge each reason",
    );
    expect(text).toContain("- worker-M1.L1: REJECTED: BUG a — stale diff");
    expect(text).not.toContain("before the review");
  });

  it("tells the judge how to treat a DESIGN line, with the lane's tasks", async () => {
    const { run } = await planned();
    mkdirSync(join(run.dir, "roles", "worker-M1.L1", "D1"), { recursive: true });
    writeFileSync(
      join(run.dir, "roles", "worker-M1.L1", "D1", "reply.md"),
      "DESIGN: Task 2 — x clashes — change y\nSTATUS: blocked — needs_user: Task 2 conflicts\n",
    );
    const input = {
      id: "7",
      kind: "question" as const,
      unit: "M1.L1",
      context: "Lane M1.L1: worker stopped.\nreply: roles/worker-M1.L1/D1/reply.md",
      findings: [],
      lanes: [{ id: "M1.L1", owns: ["src/a/"] }],
    };
    const text = judgeBrief(run, input);
    expect(text).toContain("The worker's DESIGN: line says the approved plan conflicts with the code.");
    expect(text).toContain("a change to what the plan decided is the owner's: ask_owner.");
    expect(text).toContain('<plan-task file="p.md" id="2">');
    expect(judgeBrief(run, { ...input, context: "Lane M1.L1: worker stopped." })).not.toContain("DESIGN");
  });

  it("lists each DESIGN line under the report's audit", async () => {
    const { run } = await planned();
    await appendRecord(
      run,
      makeRecord({ runId: run.id, design: ["Task 2 — x — y"], dispatchId: "01J00000000000000000000C01" }),
    );
    const log = runningLog();
    const file = writeRunReport(run, log.state(), log.events);
    expect(readFileSync(file, "utf8")).toMatch(/## Audit\n\n- worker-M1.L1 DESIGN: Task 2 — x — y/);
  });
});
