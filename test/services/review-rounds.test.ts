import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crossFamilyRung, knownIssues } from "../../src/domain/architect-state.ts";
import { modelFamily } from "../../src/domain/ids.ts";
import type { ArchitectTool } from "../../src/domain/role-tools.ts";
import { describeEvent, type Finding } from "../../src/domain/run-events.ts";
import type { DispatchAction } from "../../src/domain/run-machine.ts";
import { taskBrief } from "../../src/services/architect-run.ts";
import { callArchitectTool } from "../../src/services/architect-tools.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { endDispatch, makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());

const GPT = "codex:gpt-6-sol#high";
const OPUS = "claude-code:claude-opus-5-5#medium";

function setup(
  reviewer: string[],
  attempts = 4,
): {
  run: Run;
  repo: string;
  call: (t: ArchitectTool, a: object) => Promise<unknown>;
} {
  const view = testView();
  view.roles.reviewer = { enabled: true, access: "read-only", rungs: reviewer };
  const deps = fakeDeps({ view });
  const { run, repo } = freshRun();
  const call = (tool: ArchitectTool, args: object) =>
    callArchitectTool(
      {
        deps,
        run,
        caller: { name: "architect-1", role: "architect" },
        pollMs: 1,
      },
      tool,
      args,
    );
  return {
    run,
    repo,
    call: async (t, a) => {
      if (readEvents(run).length === 0)
        await appendEvent(run, {
          type: "run.started",
          ...startedFields,
          caps: { wallMin: 720, attempts },
        });
      return call(t, a);
    },
  };
}

/** Starts and ends task `name` in the run's log, with `findings` for a review. */
async function end(
  run: Run,
  name: string,
  rung: string,
  findings: Finding[] = [],
  over: {
    status?: "failed" | "timeout";
    replyStatus?: "blocked" | "refused" | null;
  } = {},
): Promise<void> {
  const log = makeLog();
  const id = startDispatch(log, { name, unit: name, rung, role: "worker" });
  endDispatch(log, id, { name, unit: name, findings, ...over });
  for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
}

const f = (label: Finding["label"], text: string): Finding => ({
  label,
  text,
  file: null,
});

describe("converging reviews (plan 51, spec D8)", () => {
  it("names a rung's model family by its model, not its backend", () => {
    expect(modelFamily("codex:gpt-6-sol#high")).toBe("gpt");
    expect(modelFamily("opencode:opencode/gpt-6-sol#high")).toBe("gpt");
    expect(modelFamily("claude:claude-opus-5-5#low")).toBe("claude");
    expect(modelFamily("opencode:opencode-go/kimi-k3#default")).toBe("kimi");
    expect(crossFamilyRung([GPT, OPUS], GPT, "codex:gpt-6-luna#high")).toEqual({
      rung: OPUS,
      sameFamily: false,
    });
    expect(crossFamilyRung([GPT], GPT, "codex:gpt-6-luna#high")).toEqual({
      rung: GPT,
      sameFamily: true,
    });
    expect(crossFamilyRung([GPT], GPT, null)).toEqual({
      rung: GPT,
      sameFamily: false,
    });
  });

  it("runs a review with no rung on another family than the work, and marks a same-family one", async () => {
    const cross = setup([GPT, OPUS]);
    await cross.call("ledger", {
      tasks: { add: [{ id: "L1", goal: "the parser" }] },
      why: "w",
    });
    await cross.call("delegate_task", {
      role: "worker",
      task: "parse",
      ledgerTask: "L1",
      why: "w",
    });
    await end(cross.run, "T1", "codex:gpt-6-luna#high");
    expect(
      await cross.call("delegate_task", {
        role: "reviewer",
        task: "review it",
        ledgerTask: "L1",
        why: "w",
      }),
    ).toMatchObject({ rung: OPUS, sameFamily: false });

    const same = setup([GPT]);
    await same.call("ledger", {
      tasks: { add: [{ id: "L1", goal: "the parser" }] },
      why: "w",
    });
    await same.call("delegate_task", {
      role: "worker",
      task: "parse",
      ledgerTask: "L1",
      why: "w",
    });
    await end(same.run, "T1", "codex:gpt-6-luna#high");
    expect(
      await same.call("delegate_task", {
        role: "reviewer",
        task: "review it",
        ledgerTask: "L1",
        why: "w",
      }),
    ).toMatchObject({ rung: GPT, sameFamily: true });
    const e = readEvents(same.run).at(-1);
    expect(e).toMatchObject({ type: "task.delegated", sameFamily: true });
    expect(describeEvent(e as never)).toContain("(same-family review)");
  });

  it("refuses a fourth review round on one ledger task until the architect replans it", async () => {
    const { call } = setup([GPT]);
    await call("ledger", {
      tasks: { add: [{ id: "L1", goal: "the parser" }] },
      why: "w",
    });
    const review = () =>
      call("delegate_task", {
        role: "reviewer",
        task: "r",
        ledgerTask: "L1",
        why: "w",
      });
    for (let i = 0; i < 3; i++) await review();
    await expect(review()).rejects.toMatchObject({
      message: expect.stringContaining("3 review rounds"),
    });
    await call("ledger", {
      tasks: { set: [{ id: "L1", goal: "the parser, as a table" }] },
      why: "replan",
    });
    expect(await review()).toMatchObject({ taskId: "T4" });
  });

  it("counts a ledger task's work against the attempts cap, never its reviews", async () => {
    const { call } = setup([GPT], 2);
    await call("ledger", {
      tasks: { add: [{ id: "L1", goal: "the parser" }] },
      why: "w",
    });
    const run = (role: string) => call("delegate_task", { role, task: "x", ledgerTask: "L1", why: "w" });
    await run("worker");
    await run("reviewer");
    await run("worker");
    await expect(run("worker")).rejects.toMatchObject({
      message: expect.stringContaining("its 2 attempts"),
    });
  });

  it("snapshots the tree a review reads, untouched, and gives a re-review only the diff since and the earlier findings", async () => {
    const { run, repo, call } = setup([GPT]);
    await call("ledger", {
      tasks: { add: [{ id: "L1", goal: "the parser" }] },
      why: "w",
    });
    writeFileSync(join(repo, "new.txt"), "draft\n");
    await call("delegate_task", {
      role: "reviewer",
      task: "review",
      ledgerTask: "L1",
      why: "w",
    });
    const first = replayRun(run).arch.tasks.T1?.snapshot as string;
    expect(
      execFileSync("git", ["-C", repo, "show", `${first}:new.txt`], {
        encoding: "utf8",
      }),
    ).toBe("draft\n");
    expect(
      execFileSync("git", ["-C", repo, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toContain("?? new.txt");
    await end(run, "T1", GPT, [f("IMPORTANT", "IMPORTANT (unchecked null) new.txt:1 — x — y — z")]);
    writeFileSync(join(repo, "new.txt"), "fixed\n");
    await call("delegate_task", {
      role: "reviewer",
      task: "review again",
      ledgerTask: "L1",
      why: "w",
    });
    const second = replayRun(run).arch.tasks.T2?.snapshot as string;
    expect(second).not.toBe(first);
    const action = { name: "T2", unit: "T2", brief: "task" } as DispatchAction;
    const brief = taskBrief(run, replayRun(run), action).round.join("\n");
    expect(brief).toContain(`git diff ${first} ${second}`);
    expect(brief).toContain("1. IMPORTANT (unchecked null) new.txt:1");
  });

  it("ignores a failed review: it is no diff base and uses up no round", async () => {
    const { run, repo, call } = setup([GPT]);
    await call("ledger", {
      tasks: { add: [{ id: "L1", goal: "the parser" }] },
      why: "w",
    });
    const review = () =>
      call("delegate_task", {
        role: "reviewer",
        task: "r",
        ledgerTask: "L1",
        why: "w",
      });
    writeFileSync(join(repo, "new.txt"), "one\n");
    await review();
    await end(run, "T1", GPT);
    writeFileSync(join(repo, "new.txt"), "two\n");
    await review();
    await end(run, "T2", GPT, [], { status: "timeout" });
    writeFileSync(join(repo, "new.txt"), "three\n");
    await review();
    const arch = replayRun(run).arch;
    const brief = taskBrief(run, replayRun(run), {
      name: "T3",
      unit: "T3",
      brief: "task",
    } as DispatchAction);
    expect(brief.round.join("\n")).toContain(
      `git diff ${arch.tasks.T1?.snapshot} ${arch.tasks.T3?.snapshot}`,
    );
    await end(run, "T3", GPT);
    await review();
    await end(run, "T4", GPT, [], { replyStatus: "blocked" });
    // T1 and T3 are the rounds: T2 (timeout) and T4 (blocked) are not
    expect(await review()).toMatchObject({ taskId: "T5" });
  });

  it("numbers a review's findings, logs their handling and a missed bug, and lists the known issues", async () => {
    const { run, call } = setup([GPT]);
    await call("ledger", {
      tasks: { add: [{ id: "L1", goal: "the parser" }] },
      why: "w",
    });
    await call("delegate_task", {
      role: "reviewer",
      task: "r",
      ledgerTask: "L1",
      why: "w",
    });
    await end(run, "T1", GPT, [
      f("IMPORTANT", "a"),
      f("NIT", "b"),
      f("PRE-EXISTING", "c"),
      f("IMPORTANT", "d"),
    ]);
    expect(replayRun(run).arch.inbox.at(-1)?.text).toContain("2 important, 1 nit, 1 pre-existing");
    expect(await call("task_status", { taskId: "T1" })).toMatchObject({
      findings: [{ n: 1, severity: "IMPORTANT", handled: null }, { n: 2 }, { n: 3 }, { n: 4 }],
    });
    await call("findings", {
      taskId: "T1",
      handled: [
        { n: 1, as: "fix" },
        { n: 2, as: "known-issue" },
      ],
      why: "w",
    });
    await expect(
      call("findings", {
        taskId: "T1",
        handled: [{ n: 5, as: "fix" }],
        why: "w",
      }),
    ).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
    await call("findings", {
      missed: {
        ledgerTask: "L1",
        bug: "loses the refund",
        caughtBy: "verifier",
      },
      why: "w",
    });
    expect(readEvents(run).at(-1)).toMatchObject({
      type: "review.missed",
      caughtBy: "verifier",
      review: null,
    });
    expect(knownIssues(replayRun(run).arch, [])).toEqual([
      "T1 #2: b",
      "T1 #3: c",
      "T1 #4 (no handling logged): d",
    ]);
  });
});
